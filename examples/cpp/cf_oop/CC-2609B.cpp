#include<iostream>
using namespace std;
class matrix{
	int *data;
	int mn;
	public:
	matrix(int n){
		mn=n;
		data=new int[n*n];
	}
	friend istream &operator>>(istream &is,matrix &c);
    friend ostream& operator<<(ostream& os,const matrix& c);

	matrix operator +(matrix m){
		matrix result(mn);
		for(int i=0;i<mn*mn;i++)result.data[i]=data[i]+m.data[i];
		return result;
	}
	matrix operator -(matrix m){
		matrix result(mn);
		for(int i=0;i<mn*mn;i++)result.data[i]=data[i]-m.data[i];
		return result;
	}
	matrix operator *(matrix m){
		matrix result(mn);
		for(int i=0;i<mn;i++){
			for(int j=0;j<mn;j++){
				int sum=0;
				for(int k=0;k<mn;k++)sum+=data[i*mn+k]*m.data[k*mn+j];
				result.data[i*mn+j]=sum;
			}
		}
		return result;
	}
};
istream &operator>>(istream &is,matrix &c){
	for(int i=0;i<c.mn*c.mn;i++)is>>c.data[i];
	return is;
}
ostream& operator<<(ostream& os,const matrix& c){
  	for(int i=0;i<c.mn*c.mn;i++){
  		if(i!=0 &&i%c.mn==0)os<<endl;
  		os<<c.data[i]<<" ";
  	}
  	os<<endl;
	return os;
}
int main(){
	int n;
	cin>>n;
	matrix a(n);
	matrix b(n);
	cin>>a>>b;
	cout<<a+b<<endl;  //@ @guide uml:a
	cout<<a-b<<endl;
	cout<<a*b<<endl;

}
