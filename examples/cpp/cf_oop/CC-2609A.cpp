#include<iostream>
using namespace std;

class Matrix{
	int data[2][2];
	public:
	friend istream &operator>>(istream &is,Matrix &c);
	friend ostream &operator<<(ostream &os,const Matrix &c);

	Matrix operator +(const Matrix &m) const{
		Matrix result;
		for(int i=0;i<2;i++)
			for(int j=0;j<2;j++)
				result.data[i][j]=data[i][j]+m.data[i][j];
		return result;
	}
	Matrix operator -(const Matrix &m) const{
		Matrix result;
		for(int i=0;i<2;i++)
			for(int j=0;j<2;j++)
				result.data[i][j]=data[i][j]-m.data[i][j];
		return result;
	}
	Matrix operator *(const Matrix &m) const{
		Matrix result;
		for(int i=0;i<2;i++){
			for(int j=0;j<2;j++){
				int sum=0;
				for(int k=0;k<2;k++)sum+=data[i][k]*m.data[k][j];
				result.data[i][j]=sum;
			}
		}
		return result;
	}
};

istream &operator>>(istream &is,Matrix &c){
	for(int i=0;i<2;i++)
		for(int j=0;j<2;j++)
			is>>c.data[i][j];
	return is;
}

ostream &operator<<(ostream &os,const Matrix &c){
	for(int i=0;i<2;i++){
		os<<" "<<c.data[i][0]<<" "<<c.data[i][1]<<endl;
	}
	return os;
}

int main(){
   Matrix a,b;cin>>a>>b;
   cout<<"a:"<<endl<<a<<endl;  //@ @guide uml:a
   cout<<"b:"<<endl<<b<<endl;
   cout<<"a+b:"<<endl<<a+b<<endl;
   cout<<"a-b:"<<endl<<a-b<<endl;
   cout<<"a*b:"<<endl<<a*b<<endl;
   return 0;
}
