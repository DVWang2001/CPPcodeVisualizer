#include<iostream>
#include<vector>
#include<algorithm>
#include<cstdlib>
using namespace std;
class Frac{public:
  __int64 m_n,m_d;
  Frac(int n=0,int d=1):m_n(n),m_d(d){
    __int64 g = std::__gcd((m_n<0?-m_n:m_n),(m_d<0?-m_d:m_d));
    if(g!=0){ m_n/=g; m_d/=g; }
  }
	Frac operator+(const Frac& b)const{
		return Frac((int)(m_n*b.m_d+m_d*b.m_n),(int)(m_d*b.m_d));
	}
	Frac operator*(const Frac& b)const{
		return Frac((int)(m_n*b.m_n),(int)(m_d*b.m_d));
	}
	Frac operator/(int b)const{
		return Frac((int)m_n,(int)(m_d*b));
	}
};
istream& operator>>(istream &is,Frac &a){
  char c;
  return is>>a.m_n>>c>>a.m_d;
}
ostream& operator<<(ostream &os,const Frac &a){return os<<a.m_n<<"/"<<a.m_d;}
class FVec{public:
  vector<Frac> m_vs;
	Frac sum()const{
		Frac s=m_vs[0];
		for(size_t i=1;i<m_vs.size();i++) s=s+m_vs[i];
		return s;
	}
	Frac pro()const{
		Frac p=m_vs[0];
		for(size_t i=1;i<m_vs.size();i++) p=p*m_vs[i];
		return p;
	}
	Frac avg()const{
		return sum()/(int)m_vs.size();
	}
};
istream& operator>>(istream &is,FVec &vs){
	int n;is>>n;
	for(int i=0;i<n;i++){Frac f;is>>f;vs.m_vs.push_back(f);}
	return is;
}
int main(){
  FVec a;cin>>a;
  cout<<a.sum()<<endl<<a.pro()<<endl<<a.avg()<<endl;  //@ @guide uml:a
  return 0;
}
